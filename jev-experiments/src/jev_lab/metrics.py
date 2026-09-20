from __future__ import annotations

import numpy as np
from sklearn.metrics import f1_score


def classification(rows: list[dict]) -> dict:
    valid = [r for r in rows if "prediction" in r and "target" in r]
    total = len(rows)
    correct = sum(r["prediction"] == r["target"] for r in valid)
    result = {
        "attempted": total,
        "answered": len(valid),
        "failed": total - len(valid),
        "accuracy_all_attempted": correct / total if total else None,
        "accuracy_answered": correct / len(valid) if valid else None,
    }
    if not valid:
        return result
    result["macro_f1"] = float(
        f1_score([r["target"] for r in valid], [r["prediction"] for r in valid], average="macro")
    )
    probabilistic = [r for r in valid if r.get("probabilities") is not None]
    if probabilistic:
        probs = [r["probabilities"].get(r["prediction"], 0) for r in probabilistic]
        hits = [r["prediction"] == r["target"] for r in probabilistic]
        result["brier_multiclass"] = float(
            np.mean(
                [
                    sum((p - float(k == r["target"])) ** 2 for k, p in r["probabilities"].items())
                    for r in probabilistic
                ]
            )
        )
        bins = []
        for i in range(10):
            idx = [
                j
                for j, p in enumerate(probs)
                if i / 10 <= p <= (i + 1) / 10 and (i == 0 or p > i / 10)
            ]
            if idx:
                bins.append(
                    {
                        "count": len(idx),
                        "mean_probability": float(np.mean([probs[j] for j in idx])),
                        "accuracy": float(np.mean([hits[j] for j in idx])),
                    }
                )
        result["reliability_bins"] = bins
        result["ece_10_bins"] = sum(
            b["count"] * abs(b["mean_probability"] - b["accuracy"]) for b in bins
        ) / len(probabilistic)
        result["risk_coverage"] = []
        for threshold in (0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.99):
            selected = [r for r, p in zip(probabilistic, probs) if p >= threshold]
            result["risk_coverage"].append(
                {
                    "threshold": threshold,
                    "accepted": len(selected),
                    "coverage_all_attempted": len(selected) / total,
                    "error_rate": (
                        sum(r["prediction"] != r["target"] for r in selected) / len(selected)
                        if selected
                        else None
                    ),
                }
            )
    times = [r["latency_ms"] for r in valid if "latency_ms" in r]
    if times:
        result["latency_ms"] = {
            "p50": float(np.percentile(times, 50)),
            "p95": float(np.percentile(times, 95)),
        }
    return result


def paired_bootstrap(a, b, seed=42, iterations=2000):
    """Resample independent cases, never alternate representations of the same case."""
    diff = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    if len(diff) == 0:
        return None
    rng = np.random.default_rng(seed)
    means = [rng.choice(diff, len(diff), replace=True).mean() for _ in range(iterations)]
    return {
        "mean_difference": float(diff.mean()),
        "interval_95": [float(v) for v in np.percentile(means, [2.5, 97.5])],
        "independent_cases": len(diff),
    }
